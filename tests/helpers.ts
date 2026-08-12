import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Config } from "../src/config.js";
import type { CommandRunner } from "../src/exec.js";
import type { FetchLike } from "../src/llm-client.js";

/**
 * EVERY ROOT THIS FUNCTION HANDS OUT IS TRACKED, because most of them were never given
 * back. Nine suites — fs-safety, implement, models-tool, regression, retry, scaffold,
 * session-token-walk, status, stdio — called `makeTempRoot` 56 times between them and
 * removed NOTHING. Measured on this machine on 2026-08-12: **20,021** `local-coder-*`
 * directories and 89 `b12-*` directories in the Windows temp folder, dated from 2026-08-02
 * to that morning — every test run this project has ever done, still on disk.
 *
 * That is not only untidiness. `mkdtempSync`, `fs.rm` and every `git init` under it work
 * inside that folder, so the leak makes each subsequent run slower and more lock-prone
 * than the last — which is the same directory pressure the ENOTEMPTY teardown failures
 * came out of. A suite that degrades the machine it runs on will eventually disagree with
 * itself, and it did.
 *
 * `tests/setup.ts` sweeps this registry in an `afterAll`, so a suite that forgets is
 * covered without having to remember. AFTER-ALL rather than after-each on purpose:
 * `tests/stdio.test.ts:43` creates its root at collection time and spawns a server with it
 * as cwd, and a per-test sweep would delete the ground under a live child process.
 */
const trackedRoots = new Set<string>();

export function makeTempRoot(prefix = "local-coder-test-"): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedRoots.add(root);
  return root;
}

/**
 * Remove every root handed out by `makeTempRoot` that is still on disk.
 *
 * THIS ONE WARNS WHERE `removeTempRoot` THROWS, and the difference is deliberate. An
 * explicit `afterEach` calling `removeTempRoot` is a suite asserting it cleaned up after
 * itself, so a lock surviving the retries there is evidence worth a red. This is a net
 * under suites that never made that promise; failing them for it would be inventing an
 * assertion they never wrote. Both leave the path on the record either way.
 */
export async function sweepTempRoots(): Promise<void> {
  const roots = [...trackedRoots];
  trackedRoots.clear();
  for (const root of roots) {
    try {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      console.warn(`[tests] sweep left a scratch root on disk: ${root} — ${why}`);
    }
  }
}

/**
 * REMOVE A SCRATCH ROOT WITHOUT TURNING WINDOWS' FILE LOCKING INTO A TEST RESULT.
 *
 * Every suite here used a bare `fs.rm(root, { recursive: true, force: true })` in
 * `afterEach`. `force` ignores a MISSING path; it does nothing for a BUSY one, and
 * `maxRetries` defaults to **0** — so the first `ENOTEMPTY` propagated out of the hook and
 * vitest attributed it to whichever test the hook was closing.
 *
 * MEASURED, not supposed. Three consecutive gate runs over trees differing only in one
 * JSON data file produced three different failure sets. The causes recovered from the raw
 * reporter output:
 *
 *   ENOTEMPTY: directory not empty, rmdir '...\b12-manifest-test-QDZDnu\b12-corpus'
 *   ENOTEMPTY: directory not empty, rmdir '...\b12-manifest-test-XL1nEb\b12-corpus\a08'
 *   ENOTEMPTY: directory not empty, rmdir '...\b12-audit-test-bHSnkG'
 *
 * Different paths, different runs, same class. These suites drive `git` through
 * `spawnSync`, and on Windows the child's handles can outlive the call that waited for it.
 *
 * THE RETRY IS ONE OF THREE FIXES, not the whole of it — the suite's answer also moved
 * because vitest had no config and ran on a 5000 ms default (`vitest.config.ts`) and
 * because nine suites never removed their roots at all (`sweepTempRoots`, below).
 * `fs.rm` documents retrying on the five error codes above and the project never asked it
 * to. With ten retries the three suites that produced the ENOTEMPTY above went 87/87 green
 * and the fallback below never fired once.
 *
 * IT STILL THROWS, AND THAT IS THE SECOND DECISION. An earlier draft swallowed the final
 * failure on the argument that a file handle is not what "REFUSES an A n B intersection"
 * asserts. Adversarial review killed it: a bare catch swallows EVERY error, so a real
 * handle leak in shipped code — `atomicWriteFile` in `src/fs-safety.ts` opens a
 * `FileHandle` it must close — would report green where teardown used to be the backstop
 * that caught it. After ten retries a lock is EVIDENCE, not noise. What is kept from that
 * draft is only the part that was right: the message says TEARDOWN, by name, so the next
 * person does not go looking for the defect inside whichever test the hook was closing.
 */
export async function removeTempRoot(root: string | undefined): Promise<void> {
  if (root === undefined) return;
  try {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `TEARDOWN, not the assertion above: the scratch root ${root} could not be removed after 10 retries — ${why}. ` +
        `A lock that survives the retries is a handle nothing released; look for a child process or a FileHandle the code under test left open.`
    );
  }
}

export function testConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    root,
    baseUrl: "http://localhost:1234/v1",
    modelsCsvPath: null,
    memFitFraction: 0.85,
    // First entry is the deterministic fallback pick when no sizes are available.
    models: [
      { model: "test-solo-model", objective: "large capable coder" },
      { model: "test-ide-model", objective: "small fast coder" },
    ],
    temperature: 0.1,
    maxOutputTokens: 8192,
    timeoutMs: 30_000,
    maxFileKb: 256,
    maxContextKb: 512,
    // Spelled out even though they match DEFAULTS. The original reason was that
    // `tsconfig.json` included `src/**` only, so NOTHING type-checked this
    // literal against `Config` — a missing numeric field reached the output cap
    // as undefined, made the budget NaN, and every comparison against NaN is
    // false, so the pre-flight refused every generation in the suite. `tests/**`
    // is in the config now and `tsc` would catch it, which is why that is worth
    // saying rather than deleting: the explicitness is no longer the guard.
    outputBytesPerToken: 3.5,
    inputBytesPerToken: 3.9,
    outputUsableFraction: 0.9,
    // null = "probe lms", and `resolveContextTokens` declines to probe when a
    // fetch was injected and no runner was, so the suite stays offline. Spelled
    // out for the reason above: omitted, it arrives as undefined.
    contextTokens: null,
    // OFF here, unlike the shipped default. A test root is a scratch directory,
    // and a suite that quietly wrote CLAUDE.md into one would be exercising a
    // side effect nobody asked for. `tests/claude-md.test.ts` turns it on
    // deliberately, which is the only place it belongs.
    autoClaudeMd: false,
    ...overrides,
  };
}

/** A CommandRunner driven by a map of command → stdout. Throws for anything unmapped. */
export function fakeRunner(handlers: Record<string, () => string>): CommandRunner {
  return async (command) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command: ${command}`);
    return handler();
  };
}

/**
 * A CommandRunner where every command fails. Keeps unit tests hermetic on dev
 * machines that actually have `lms` installed: sizes stay unknown, so model
 * selection falls back to catalog order deterministically.
 */
export function noLmsRunner(): CommandRunner {
  return async (command) => {
    throw new Error(`command not available in tests: ${command}`);
  };
}

/** Build a canned `lms ls --json` body from {id, sizeBytes} entries. */
export function lmsListBody(models: Array<{ id: string; sizeBytes: number }>): string {
  return JSON.stringify(models.map((m) => ({ path: m.id, sizeBytes: m.sizeBytes })));
}

export interface ChatBodyOptions {
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
  /**
   * Drop the `usage` block entirely — an older server, a proxy, a version skew.
   * The distinction matters because zero tokens and no measurement are different
   * facts, and only one of them may be scored against a context window.
   */
  omitUsage?: boolean;
}

/** OpenAI-compatible chat completion response body. */
export function chatBody(content: string, options: ChatBodyOptions = {}): object {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: options.model ?? "test-solo-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: options.finishReason ?? "stop",
      },
    ],
    ...(options.omitUsage === true
      ? {}
      : {
          usage: {
            prompt_tokens: options.promptTokens ?? 100,
            completion_tokens: options.completionTokens ?? 50,
            total_tokens: (options.promptTokens ?? 100) + (options.completionTokens ?? 50),
          },
        }),
  };
}

export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
  body: unknown;
}

export interface QueuedFetch {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
}

/**
 * fetch mock fed from a queue of response bodies. Records every request
 * (URL + parsed JSON body). Throws if called more times than bodies queued.
 */
export function queuedFetch(bodies: object[]): QueuedFetch {
  const queue = [...bodies];
  const calls: RecordedCall[] = [];
  // `Parameters<FetchLike>` rather than `RequestInfo`, which is a DOM lib name
  // and `lib` is `["ES2022"]`. This read as valid for as long as nothing
  // type-checked this tree; it is the same type either way, taken from the alias
  // the server itself passes around.
  const fetchImpl = (async (input: Parameters<FetchLike>[0], init?: RequestInit) => {
    const url = String(input);
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, init, body: rawBody !== undefined ? JSON.parse(rawBody) : undefined });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`queuedFetch exhausted: unexpected request #${calls.length} to ${url}`);
    }
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
  return { fetchImpl, calls };
}

/** fetch mock that always rejects — the unreachable-endpoint case. */
export function unreachableFetch(): FetchLike {
  return (async () => {
    throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:1234");
  }) as FetchLike;
}

export async function writeFileTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
}

/** Wrap file content in the model's <file> block output format. */
export function fileBlock(relPath: string, content: string): string {
  return `<file path="${relPath}">\n${content}</file>`;
}
